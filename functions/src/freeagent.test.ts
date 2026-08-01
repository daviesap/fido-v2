import { describe, expect, it } from "vitest";

import {
  FREEAGENT_REDIRECT_URI,
  buildFreeAgentAuthorizationUrl,
  decryptSecret,
  encryptSecret,
  exchangeFreeAgentCode,
  fetchFreeAgentIdentity,
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

  it("encrypts tokens with authenticated encryption", () => {
    const encrypted = encryptSecret("very-secret-token", key);
    expect(encrypted.ciphertext).not.toContain("very-secret-token");
    expect(decryptSecret(encrypted, key)).toBe("very-secret-token");
    expect(() => decryptSecret({ ...encrypted, ciphertext: Buffer.from("changed").toString("base64") }, key)).toThrow();
  });
});
