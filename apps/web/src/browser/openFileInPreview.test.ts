import { describe, expect, it } from "vite-plus/test";

import { fileUrlFromAbsolutePath, isBrowserPreviewFile } from "./openFileInPreview";

describe("fileUrlFromAbsolutePath", () => {
  it("encodes a posix path", () => {
    expect(fileUrlFromAbsolutePath("/Users/x/report.html")).toBe("file:///Users/x/report.html");
  });

  it("encodes characters that would otherwise truncate the URL", () => {
    expect(fileUrlFromAbsolutePath("/tmp/my report #2.html")).toBe(
      "file:///tmp/my%20report%20%232.html",
    );
  });

  it("leaves the separators alone", () => {
    expect(fileUrlFromAbsolutePath("/a/b/c/index.html")).toBe("file:///a/b/c/index.html");
  });

  it("maps a windows drive path", () => {
    expect(fileUrlFromAbsolutePath("C:\\Users\\x\\report.html")).toBe(
      "file:///C:/Users/x/report.html",
    );
  });

  it("keeps the host of a UNC share", () => {
    expect(fileUrlFromAbsolutePath("\\\\server\\share\\page.html")).toBe(
      "file://server/share/page.html",
    );
  });

  it("refuses a relative path, which has no absolute meaning to the guest", () => {
    expect(fileUrlFromAbsolutePath("docs/report.html")).toBeNull();
    expect(fileUrlFromAbsolutePath("./report.html")).toBeNull();
  });
});

describe("isBrowserPreviewFile", () => {
  it("accepts the page types the panel can render", () => {
    expect(isBrowserPreviewFile("/a/index.html")).toBe(true);
    expect(isBrowserPreviewFile("/a/index.htm")).toBe(true);
    expect(isBrowserPreviewFile("/a/paper.PDF")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isBrowserPreviewFile("/a/main.ts")).toBe(false);
    expect(isBrowserPreviewFile("/a/notes.md")).toBe(false);
  });
});
