import { describe, expect, it } from "vitest";
import { parseBillingLink } from "../billingLink";

describe("parseBillingLink", () => {
  it("accepts both foldings, with and without a vault", () => {
    expect(parseBillingLink("secondbrain://billing/upgraded")).toEqual({ orgId: null });
    expect(parseBillingLink("secondbrain:///billing/upgraded/")).toEqual({ orgId: null });
    expect(parseBillingLink("secondbrain://billing/upgraded?org=WmpuI6BO")).toEqual({
      orgId: "WmpuI6BO",
    });
    expect(parseBillingLink("secondbrain:///billing/upgraded?org=abc%2Fdef")).toEqual({
      orgId: "abc/def",
    });
  });

  it("accepts the Staging and dev builds' schemes too", () => {
    expect(parseBillingLink("secondbrain-staging://billing/upgraded?org=x")).toEqual({ orgId: "x" });
    expect(parseBillingLink("secondbrain-dev://billing/upgraded?org=x")).toEqual({ orgId: "x" });
  });

  it("treats an empty org as absent", () => {
    expect(parseBillingLink("secondbrain://billing/upgraded?org=")).toEqual({ orgId: null });
    expect(parseBillingLink("secondbrain://billing/upgraded?org=%20")).toEqual({ orgId: null });
  });

  it("refuses anything else", () => {
    for (const bad of [
      "secondbrain://billing",
      "secondbrain://billing/canceled",
      "secondbrain://billing/upgraded/extra",
      "secondbrain://upgraded",
      "secondbrain://verified",
      "https://example.com/billing/upgraded",
      "not a url",
      "secondbrain://",
    ]) {
      expect(parseBillingLink(bad)).toBeNull();
    }
  });
});
