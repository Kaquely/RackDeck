import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PEER_TOKEN_PATTERN, generatePeerToken, isPeerToken } from "../../src/shared/peer-token.ts";

describe("peer tokens", () => {
  it("generates a token with the documented shape", () => {
    const token = generatePeerToken();

    assert.match(token, PEER_TOKEN_PATTERN);
    assert.equal(token.length, "hlp_".length + 43);
    assert.equal(isPeerToken(token), true);
  });

  it("generates distinct tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generatePeerToken()));
    assert.equal(tokens.size, 100);
  });

  it("rejects malformed values", () => {
    const valid = generatePeerToken();
    const candidates: unknown[] = [
      "",
      "hlp_",
      "hlp_short",
      "hlp_" + "a".repeat(42),
      "hlp_" + "a".repeat(44),
      "HLP_" + "a".repeat(43),
      "blp_" + "a".repeat(43),
      `${valid}=`,
      `${valid} `,
      ` ${valid}`,
      undefined,
      null,
      42,
    ];

    for (const candidate of candidates) {
      assert.equal(isPeerToken(candidate), false, `accepted ${String(candidate)}`);
    }
  });

  it("accepts every base64url character", () => {
    assert.equal(isPeerToken(`hlp_${"-".repeat(43)}`), true);
    assert.equal(isPeerToken(`hlp_${"_".repeat(43)}`), true);
    assert.equal(isPeerToken(`hlp_${"aZ09".repeat(10)}abc`), true);
  });
});
