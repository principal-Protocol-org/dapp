import { Logo } from "@/components/landing/brand"
import { Container } from "@/components/landing/layout"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The app's static shell while the server resolves the market list (the registry is request-time
 * data): the header's frame and a page placeholder, sized like the real ones so nothing jumps.
 */
export function AppShellFallback() {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line bg-ground/86 backdrop-blur-md">
        <Container className="flex items-center justify-between gap-4 py-2 min-[700px]:h-16 min-[700px]:py-0">
          <span className="inline-flex items-center text-ink">
            <Logo className="h-[26px] min-[700px]:h-[30px]" />
          </span>
          <Skeleton className="h-9 w-32" />
        </Container>
      </header>
      <main id="main" className="min-h-[60vh] bg-ground py-8 text-ink" aria-busy="true">
        <Container>
          <p className="sr-only">Loading the markets…</p>
          <div className="grid gap-6">
            <Skeleton className="h-9 w-48 max-w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </Container>
      </main>
    </>
  )
}
