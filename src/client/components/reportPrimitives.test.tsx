import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkChips, LinkableValue, safeExternalHref } from "./reportPrimitives";

describe("safeExternalHref", () => {
  it("allows http and https URLs", () => {
    expect(safeExternalHref("https://github.com/x/y/pull/1")).toBe("https://github.com/x/y/pull/1");
    expect(safeExternalHref("http://example.com/")).toBe("http://example.com/");
  });

  it("rejects non-http(s) and malformed hrefs", () => {
    expect(safeExternalHref("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalHref("data:text/html,<script>")).toBeUndefined();
    expect(safeExternalHref("/relative/path")).toBeUndefined();
    expect(safeExternalHref(undefined)).toBeUndefined();
    expect(safeExternalHref("not a url")).toBeUndefined();
  });
});

describe("LinkableValue", () => {
  it("renders a safe link when href is valid", () => {
    render(<LinkableValue href="https://github.com/x/y/tree/main" value="main" />);
    const link = screen.getByRole("link", { name: "main" });
    expect(link).toHaveAttribute("href", "https://github.com/x/y/tree/main");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("renders plain text for an unsafe or absent href", () => {
    render(<LinkableValue href="javascript:alert(1)" value="main" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
  });
});

describe("LinkChips", () => {
  it("renders only chips with safe hrefs", () => {
    render(<LinkChips links={[{ label: "#1", href: "https://github.com/x/y/pull/1" }, { label: "#2", href: "javascript:alert(1)" }]} />);
    expect(screen.getByRole("link", { name: "#1" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "#2" })).not.toBeInTheDocument();
  });

  it("renders nothing when no link is safe", () => {
    const { container } = render(<LinkChips links={[{ label: "#2", href: "javascript:alert(1)" }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
