import { Button, ButtonArrow } from "@/components/ui/button";
import { links } from "@/lib/content";
import { Logo } from "./brand";
import { Container, Section } from "./layout";

/** Always-dark band in the PT navy, in both themes. */
export function CallToAction() {
  return (
    <Section aria-labelledby="cta-title" className="relative overflow-hidden bg-band text-band-ink">
      {/* The split coin as a full-height watermark, centred in the band. */}
      <svg
        aria-hidden="true"
        viewBox="0 44 185.76 172"
        className="pointer-events-none absolute top-0 left-[54%] h-full w-auto -translate-x-1/2 fill-band-ink opacity-[0.06]"
      >
        <path d="M86 44A86 86 0 0 0 86 216Z" />
        <path d="M99.76 44A86 86 0 0 1 99.76 216Z" />
      </svg>
      <Container className="relative grid items-end gap-12 min-[861px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <div className="grid gap-4">
            <span className="label inline-flex items-center gap-2.5 text-band-muted before:h-3.5 before:w-[7px] before:flex-none before:rounded-l-[14px] before:bg-band-par before:content-['']">
              Coming soon on Stellar mainnet
            </span>
            <h2 id="cta-title" className="display-l text-band-ink">
              Unlock yield markets on Stellar.
            </h2>
          </div>
          <p className="lead mt-4 text-band-muted">
            Access fixed yield, future yield trading, and a new generation of RWA financial products built on Stellar.
          </p>
        </div>
        <div className="flex flex-wrap justify-start gap-3">
          <Button asChild variant="band-primary">
            <a href={links.app}>
              Launch app <ButtonArrow />
            </a>
          </Button>
          <Button asChild variant="band-secondary">
            <a href={links.docs} target="_blank" rel="noopener">
              Read documentation
            </a>
          </Button>
        </div>
      </Container>
    </Section>
  );
}

const footerLinks = [
  { label: "Documentation", href: links.docs },
  { label: "GitHub", href: links.github },
  { label: "Discord", href: links.discord },
  { label: "X (Twitter)", href: links.x },
].filter((l): l is { label: string; href: string } => Boolean(l.href));

export function SiteFooter() {
  return (
    <footer className="border-t border-line py-12">
      <Container>
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="grid gap-4">
            <a href="#top" aria-label="Principal home" className="inline-flex items-center text-ink">
              <Logo className="h-[26px]" />
            </a>
            <p className="max-w-[44ch] text-sm/6 text-ink-muted">
              Principal is a yield tokenization infrastructure for Stellar Real-World Assets.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-6">
            {footerLinks.map((l) => (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noopener"
                className="text-sm/6 text-ink-muted hover:text-ink"
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>
        <p className="mt-8 text-xs/[18px] text-ink-muted">© 2026 Principal. All rights reserved.</p>
      </Container>
    </footer>
  );
}
