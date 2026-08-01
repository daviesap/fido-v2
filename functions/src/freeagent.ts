import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

export const FREEAGENT_API_ORIGIN = "https://api.freeagent.com";
export const FREEAGENT_REDIRECT_URI = "https://fido.flair.london/oauth/freeagent/callback";
export const FREEAGENT_APP_ORIGIN = "https://fido.flair.london";
export const FREEAGENT_USER_AGENT = "Fido Receipt Manager (https://fido.flair.london)";

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  token_type: z.string().min(1).max(40),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

const OAuthErrorResponseSchema = z.object({
  error: z.enum([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
  ]),
});

const UserResponseSchema = z.object({
  user: z.object({
    url: z.string().url(),
    first_name: z.string().max(160),
    last_name: z.string().max(160),
    email: z.string().email(),
    role: z.string().max(80),
    permission_level: z.number().int().min(0).max(8),
  }),
});

const CompanyResponseSchema = z.object({
  company: z.object({
    url: z.string().url(),
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().min(1).max(240),
    subdomain: z.string().min(1).max(160),
    type: z.string().min(1).max(80),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
});

const FreeAgentUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.origin === FREEAGENT_API_ORIGIN && url.pathname.startsWith("/v2/");
}, "Expected a production FreeAgent API URL");

const BankAccountSchema = z.object({
  url: FreeAgentUrlSchema,
  type: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  currency: z.string().regex(/^[A-Z]{3}$/),
  is_personal: z.boolean(),
  status: z.enum(["active", "hidden"]),
});

const BankAccountsResponseSchema = z.object({
  bank_accounts: z.array(BankAccountSchema).max(100),
});

const SignedMoneySchema = z.string().regex(/^-?[0-9]{1,12}(?:\.[0-9]{1,10})?$/);

const BankTransactionSchema = z.object({
  url: FreeAgentUrlSchema,
  amount: SignedMoneySchema,
  bank_account: FreeAgentUrlSchema,
  dated_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().max(500),
  full_description: z.string().max(2000),
  unexplained_amount: SignedMoneySchema,
  transaction_id: z.string().max(500).nullable().optional(),
  updated_at: z.string().datetime({ offset: true }),
});

const BankTransactionsResponseSchema = z.object({
  bank_transactions: z.array(BankTransactionSchema).max(100),
});

export type FreeAgentTokens = z.infer<typeof TokenResponseSchema>;
export type FreeAgentIdentity = ReturnType<typeof parseIdentity>;
export type FreeAgentBankAccount = ReturnType<typeof normaliseBankAccount>;
export type FreeAgentBankTransaction = ReturnType<typeof normaliseBankTransaction>;

export type EncryptedSecret = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export function buildFreeAgentAuthorizationUrl(input: { clientId: string; state: string }): string {
  const url = new URL("/v2/approve_app", FREEAGENT_API_ORIGIN);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", FREEAGENT_REDIRECT_URI);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeFreeAgentCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<FreeAgentTokens> {
  return requestTokens({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: FREEAGENT_REDIRECT_URI,
    }),
    fetchImpl: input.fetchImpl,
  });
}

export async function refreshFreeAgentTokens(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<FreeAgentTokens> {
  return requestTokens({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
    fetchImpl: input.fetchImpl,
  });
}

export async function fetchFreeAgentIdentity(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<FreeAgentIdentity> {
  const [userJson, companyJson] = await Promise.all([
    freeAgentGet("/v2/users/me", accessToken, fetchImpl),
    freeAgentGet("/v2/company", accessToken, fetchImpl),
  ]);
  return parseIdentity(userJson, companyJson);
}

export async function fetchFreeAgentBankAccounts(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FreeAgentBankAccount[]> {
  const accounts = await fetchFreeAgentPages({
    path: "/v2/bank_accounts",
    accessToken,
    fetchImpl,
    parse: (value) => BankAccountsResponseSchema.parse(value).bank_accounts,
  });
  return accounts.map(normaliseBankAccount);
}

export async function fetchFreeAgentBankTransactions(input: {
  accessToken: string;
  bankAccountUrl: string;
  fromDate: string;
  toDate: string;
  fetchImpl?: typeof fetch;
}): Promise<FreeAgentBankTransaction[]> {
  const bankAccountUrl = FreeAgentUrlSchema.parse(input.bankAccountUrl);
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const fromDate = dateSchema.parse(input.fromDate);
  const toDate = dateSchema.parse(input.toDate);
  if (fromDate > toDate) throw new FreeAgentRequestError("invalid_transaction_window", 400);
  const url = new URL("/v2/bank_transactions", FREEAGENT_API_ORIGIN);
  url.searchParams.set("bank_account", bankAccountUrl);
  url.searchParams.set("from_date", fromDate);
  url.searchParams.set("to_date", toDate);
  const transactions = await fetchFreeAgentPages({
    path: `${url.pathname}${url.search}`,
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl ?? fetch,
    parse: (value) => BankTransactionsResponseSchema.parse(value).bank_transactions,
  });
  return transactions.map(normaliseBankTransaction);
}

export function encryptSecret(value: string, encodedKey: string): EncryptedSecret {
  const key = encryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecret(value: EncryptedSecret, encodedKey: string): string {
  if (value.version !== 1) throw new Error("unsupported_encryption_version");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(encodedKey), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function requestTokens(input: {
  clientId: string;
  clientSecret: string;
  body: URLSearchParams;
  fetchImpl?: typeof fetch;
}): Promise<FreeAgentTokens> {
  const response = await (input.fetchImpl ?? fetch)(`${FREEAGENT_API_ORIGIN}/v2/token_endpoint`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": FREEAGENT_USER_AGENT,
    },
    body: input.body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const parsedError = OAuthErrorResponseSchema.safeParse(await response.json().catch(() => null));
    const code = parsedError.success ? `token_${parsedError.data.error}` : "token_request_failed";
    throw new FreeAgentRequestError(code, response.status);
  }
  const parsed = TokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new FreeAgentRequestError("invalid_token_response", response.status);
  return parsed.data;
}

async function freeAgentGet(path: string, accessToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await freeAgentGetResponse(path, accessToken, fetchImpl);
  return response.json();
}

async function freeAgentGetResponse(path: string, accessToken: string, fetchImpl: typeof fetch): Promise<Response> {
  const response = await fetchImpl(`${FREEAGENT_API_ORIGIN}${path}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": FREEAGENT_USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new FreeAgentRequestError("api_request_failed", response.status);
  return response;
}

async function fetchFreeAgentPages<T>(input: {
  path: string;
  accessToken: string;
  fetchImpl: typeof fetch;
  parse: (value: unknown) => T[];
}): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const url = new URL(input.path, FREEAGENT_API_ORIGIN);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "100");
    const response = await freeAgentGetResponse(`${url.pathname}${url.search}`, input.accessToken, input.fetchImpl);
    const items = input.parse(await response.json());
    result.push(...items);
    const total = Number.parseInt(response.headers.get("x-total-count") ?? "", 10);
    if (items.length < 100 || (Number.isFinite(total) && result.length >= total)) return result;
  }
  throw new FreeAgentRequestError("pagination_limit_exceeded", 422);
}

function parseIdentity(userJson: unknown, companyJson: unknown) {
  const user = UserResponseSchema.parse(userJson).user;
  const company = CompanyResponseSchema.parse(companyJson).company;
  return {
    user: {
      url: user.url,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      role: user.role,
      permissionLevel: user.permission_level,
    },
    company: {
      url: company.url,
      id: company.id,
      name: company.name,
      subdomain: company.subdomain,
      type: company.type,
      currency: company.currency,
    },
  };
}

function normaliseBankAccount(account: z.infer<typeof BankAccountSchema>) {
  return {
    id: freeAgentResourceId(account.url, "bank_accounts"),
    url: account.url,
    name: account.name,
    type: account.type,
    currency: account.currency,
    isPersonal: account.is_personal,
    status: account.status,
  };
}

function normaliseBankTransaction(transaction: z.infer<typeof BankTransactionSchema>) {
  return {
    id: freeAgentResourceId(transaction.url, "bank_transactions"),
    url: transaction.url,
    bankAccountId: freeAgentResourceId(transaction.bank_account, "bank_accounts"),
    bankAccountUrl: transaction.bank_account,
    datedOn: transaction.dated_on,
    amount: transaction.amount,
    description: transaction.description,
    fullDescription: transaction.full_description,
    unexplainedAmount: transaction.unexplained_amount,
    transactionId: transaction.transaction_id ?? null,
    updatedAt: transaction.updated_at,
  };
}

function freeAgentResourceId(value: string, resource: "bank_accounts" | "bank_transactions"): string {
  const url = new URL(value);
  const match = url.pathname.match(new RegExp(`^/v2/${resource}/([^/]+)$`));
  if (!match?.[1] || !/^[A-Za-z0-9_-]{1,128}$/.test(match[1])) {
    throw new FreeAgentRequestError("invalid_resource_url", 502);
  }
  return match[1];
}

function encryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey.trim(), "base64");
  if (key.length !== 32) throw new Error("invalid_encryption_key");
  return key;
}

export class FreeAgentRequestError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}
