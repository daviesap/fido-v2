import { describe, expect, it } from "vitest";

import {
  FREEAGENT_REDIRECT_URI,
  buildFreeAgentAuthorizationUrl,
  decryptSecret,
  encryptSecret,
  exchangeFreeAgentCode,
  fetchFreeAgentBankAccounts,
  fetchFreeAgentBankTransactions,
  fetchFreeAgentIdentity,
  fetchFreeAgentSpendingCategories,
  FreeAgentRequestError,
  refreshFreeAgentTokens,
} from "./freeagent.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("FreeAgent OAuth", () => {
  it("builds the production authorization URL with exact redirect and state", () => {
    const url = new URL(buildFreeAgentAuthorizationUrl({ clientId: "client-id", state: "random-state" }));
    expect(url.origin).toBe("https://api.freeagent.com");
    expect(url.pathname).toBe("/v2/approve_app");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(FREEAGENT_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe("random-state");
  });

  it("exchanges and refreshes tokens with HTTP Basic auth without exposing credentials in the URL", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "bearer",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await exchangeFreeAgentCode({ clientId: "client", clientSecret: "secret", code: "code", fetchImpl });
    await refreshFreeAgentTokens({ clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetchImpl });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://api.freeagent.com/v2/token_endpoint");
    expect(requests[0]?.url).not.toContain("secret");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("client:secret").toString("base64")}`);
    expect(String(requests[0]?.init?.body)).toContain("grant_type=authorization_code");
    expect(String(requests[1]?.init?.body)).toContain("grant_type=refresh_token");
  });

  it("retains only an allow-listed OAuth error code from a failed token exchange", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      error: "invalid_client",
      error_description: "must never be retained or logged",
    }), { status: 401, headers: { "content-type": "application/json" } });

    await expect(exchangeFreeAgentCode({
      clientId: "client",
      clientSecret: "secret",
      code: "code",
      fetchImpl,
    })).rejects.toEqual(expect.objectContaining<Partial<FreeAgentRequestError>>({
      code: "token_invalid_client",
      status: 401,
    }));
  });

  it("uses a generic error when FreeAgent returns an unrecognised token error", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      error: "unexpected_sensitive_value",
    }), { status: 400, headers: { "content-type": "application/json" } });

    await expect(exchangeFreeAgentCode({
      clientId: "client",
      clientSecret: "secret",
      code: "code",
      fetchImpl,
    })).rejects.toEqual(expect.objectContaining<Partial<FreeAgentRequestError>>({
      code: "token_request_failed",
      status: 400,
    }));
  });

  it("retains only the identity and company values needed by Fido", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      const isUser = String(url).endsWith("/users/me");
      return new Response(JSON.stringify(isUser ? {
        user: {
          url: "https://api.freeagent.com/v2/users/1",
          first_name: "Andrew",
          last_name: "Davies",
          email: "andrew@example.com",
          role: "Director",
          permission_level: 8,
          ni_number: "must-not-be-retained",
        },
      } : {
        company: {
          url: "https://api.freeagent.com/v2/company",
          id: 123,
          name: "Flair London Ltd",
          subdomain: "flair",
          type: "UkLimitedCompany",
          currency: "GBP",
          sales_tax_registration_number: "must-not-be-retained",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const identity = await fetchFreeAgentIdentity("access", fetchImpl);
    expect(identity.company).toEqual({
      url: "https://api.freeagent.com/v2/company",
      id: "123",
      name: "Flair London Ltd",
      subdomain: "flair",
      type: "UkLimitedCompany",
      currency: "GBP",
    });
    expect(identity.user).not.toHaveProperty("niNumber");
  });

  it("paginates and retains only safe bank account fields", async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      requests.push(String(url));
      const page = new URL(String(url)).searchParams.get("page");
      const bank_accounts = page === "1" ? Array.from({ length: 100 }, (_, index) => ({
        url: `https://api.freeagent.com/v2/bank_accounts/${index + 1}`,
        type: index ? "CreditCardAccount" : "StandardBankAccount",
        name: `Account ${index + 1}`,
        currency: "GBP",
        is_personal: false,
        status: "active",
        account_number: "must-not-be-retained",
      })) : [{
        url: "https://api.freeagent.com/v2/bank_accounts/101",
        type: "StandardBankAccount",
        name: "Account 101",
        currency: "USD",
        is_personal: true,
        status: "hidden",
      }];
      return new Response(JSON.stringify({ bank_accounts }), {
        status: 200,
        headers: { "content-type": "application/json", "x-total-count": "101" },
      });
    };

    const accounts = await fetchFreeAgentBankAccounts("access", fetchImpl);
    expect(requests).toHaveLength(2);
    expect(accounts).toHaveLength(101);
    expect(accounts[0]).toEqual({
      id: "1",
      url: "https://api.freeagent.com/v2/bank_accounts/1",
      type: "StandardBankAccount",
      name: "Account 1",
      currency: "GBP",
      isPersonal: false,
      status: "active",
    });
    expect(accounts[0]).not.toHaveProperty("accountNumber");
  });

  it("fetches bounded bank transactions and derives stable resource ids", async () => {
    const requests: URL[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      requests.push(new URL(String(url)));
      return new Response(JSON.stringify({ bank_transactions: [{
        url: "https://api.freeagent.com/v2/bank_transactions/8",
        amount: "-12.40",
        bank_account: "https://api.freeagent.com/v2/bank_accounts/1",
        dated_on: "2026-07-31",
        description: "MAMMA DOUGH",
        full_description: "MAMMA DOUGH/OTHER/GBP 12.40",
        unexplained_amount: "-12.40",
        transaction_id: "fit-8",
        updated_at: "2026-07-31T13:00:00Z",
        bank_transaction_explanations: [{ secret: "not retained" }],
      }] }), { status: 200, headers: { "content-type": "application/json", "x-total-count": "1" } });
    };

    const transactions = await fetchFreeAgentBankTransactions({
      accessToken: "access",
      bankAccountUrl: "https://api.freeagent.com/v2/bank_accounts/1",
      fromDate: "2026-05-03",
      toDate: "2026-08-01",
      fetchImpl,
    });
    expect(requests[0]?.searchParams.get("bank_account")).toBe("https://api.freeagent.com/v2/bank_accounts/1");
    expect(requests[0]?.searchParams.get("from_date")).toBe("2026-05-03");
    expect(requests[0]?.searchParams.get("to_date")).toBe("2026-08-01");
    expect(transactions).toEqual([{
      id: "8",
      url: "https://api.freeagent.com/v2/bank_transactions/8",
      bankAccountId: "1",
      bankAccountUrl: "https://api.freeagent.com/v2/bank_accounts/1",
      datedOn: "2026-07-31",
      amount: "-12.40",
      description: "MAMMA DOUGH",
      fullDescription: "MAMMA DOUGH/OTHER/GBP 12.40",
      unexplainedAmount: "-12.40",
      transactionId: "fit-8",
      updatedAt: "2026-07-31T13:00:00Z",
    }]);
  });

  it("returns only the spending categories needed for expenses", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      admin_expenses_categories: [{
        url: "https://api.freeagent.com/v2/categories/285",
        description: "Accommodation and Meals",
        nominal_code: "285",
        group_description: "Admin expenses (normally VATable)",
        allowable_for_tax: true,
        auto_sales_tax_rate: "Standard rate",
      }],
      cost_of_sales_categories: [{
        url: "https://api.freeagent.com/v2/categories/102",
        description: "Commission Paid",
        nominal_code: "102",
        allowable_for_tax: true,
      }],
      income_categories: [{ url: "https://api.freeagent.com/v2/categories/001", description: "Sales", nominal_code: "001" }],
      general_categories: [{ url: "https://api.freeagent.com/v2/categories/051", description: "Interest", nominal_code: "051" }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    await expect(fetchFreeAgentSpendingCategories("access", fetchImpl)).resolves.toEqual([
      {
        id: "285",
        url: "https://api.freeagent.com/v2/categories/285",
        description: "Accommodation and Meals",
        nominalCode: "285",
        group: "Admin expenses",
        groupDescription: "Admin expenses (normally VATable)",
        allowableForTax: true,
        autoSalesTaxRate: "Standard rate",
      },
      {
        id: "102",
        url: "https://api.freeagent.com/v2/categories/102",
        description: "Commission Paid",
        nominalCode: "102",
        group: "Cost of sales",
        groupDescription: "Cost of sales",
        allowableForTax: true,
        autoSalesTaxRate: null,
      },
    ]);
  });

  it("rejects non-production resource URLs returned by FreeAgent", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ bank_accounts: [{
      url: "https://example.com/v2/bank_accounts/1",
      type: "StandardBankAccount",
      name: "Unsafe",
      currency: "GBP",
      is_personal: false,
      status: "active",
    }] }), { status: 200, headers: { "content-type": "application/json" } });

    await expect(fetchFreeAgentBankAccounts("access", fetchImpl)).rejects.toThrow();
  });

  it("encrypts tokens with authenticated encryption", () => {
    const encrypted = encryptSecret("very-secret-token", key);
    expect(encrypted.ciphertext).not.toContain("very-secret-token");
    expect(decryptSecret(encrypted, key)).toBe("very-secret-token");
    expect(() => decryptSecret({ ...encrypted, ciphertext: Buffer.from("changed").toString("base64") }, key)).toThrow();
  });
});
