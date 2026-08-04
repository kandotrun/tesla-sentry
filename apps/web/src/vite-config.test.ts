import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config";

describe("Vite development API proxy", () => {
  it("forwards same-origin /api requests to the local Worker", () => {
    expect(viteConfig.server?.proxy).toMatchObject({
      "/api": {
        changeOrigin: true,
        target: "http://127.0.0.1:8788",
      },
    });
  });
});
