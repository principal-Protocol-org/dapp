import { Skeleton } from "@/components/ui/skeleton"

/** The page placeholder while the server resolves the markets, sized like the overview so nothing jumps. */
export function DashboardFallback() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6" aria-busy="true">
      <p className="sr-only">Loading the dashboard…</p>
      <Skeleton className="h-9 w-64 max-w-full" />
      <Skeleton className="h-5 w-96 max-w-full" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 min-[900px]:grid-cols-2">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  )
}
