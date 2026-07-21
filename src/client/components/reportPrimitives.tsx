import type { CSSProperties } from "react";
import type { ReportLink } from "../../shared/types";

/**
 * Report data may carry arbitrary hrefs. Only http(s) URLs are rendered as
 * links so a hostile report cannot inject javascript:/data: navigation.
 */
export function safeExternalHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Render a value as a safe external link when an href is present, else text. */
export function LinkableValue({
  value,
  href,
  className,
  style
}: {
  value: string;
  href?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const safeHref = safeExternalHref(href);
  if (safeHref) {
    return (
      <a className={className} href={safeHref} rel="noreferrer" style={style} target="_blank">
        {value}
      </a>
    );
  }
  return (
    <span className={className} style={style}>
      {value}
    </span>
  );
}

/** Render an outcome row's optional links as chips (safe hrefs only). */
export function LinkChips({ links }: { links: ReportLink[] }) {
  const safe = links.flatMap((link) => {
    const href = safeExternalHref(link.href);
    return href ? [{ label: link.label, href }] : [];
  });
  if (safe.length === 0) return null;
  return (
    <span className="link-chips">
      {safe.map((link) => (
        <a className="link-chip" href={link.href} key={`${link.label}:${link.href}`} rel="noreferrer" target="_blank">
          {link.label}
        </a>
      ))}
    </span>
  );
}
