import { Button, ButtonArrow } from "@/components/ui/button";
import { links } from "@/lib/content";
import { Logo } from "./brand";
import { Container } from "./layout";
import { ThemeToggle } from "./theme-toggle";

const navLink = "text-sm font-medium text-ink-muted hover:text-ink max-[820px]:hidden";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ground/86 backdrop-blur-md">
      <Container className="flex h-16 items-center justify-between gap-4">
        <a href="#top" aria-label="Principal home" className="inline-flex items-center text-ink">
          <Logo className="h-[30px]" />
        </a>
        <nav aria-label="Primary" className="flex items-center gap-6">
          <a className={navLink} href="#markets">
            Markets
          </a>
          <a className={navLink} href="#compliance">
            Compliance
          </a>
          <a className={navLink} href={links.docs} target="_blank" rel="noopener">
            Docs
          </a>
          <ThemeToggle />
          <Button asChild className="max-[520px]:px-3.5 max-[520px]:py-2.5">
            <a href={links.app}>
              Launch app <ButtonArrow />
            </a>
          </Button>
        </nav>
      </Container>
    </header>
  );
}
