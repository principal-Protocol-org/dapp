import { cn } from "@/lib/utils";

/** 1200px column with a 16px gutter, 48px from 900px up. */
export function Container({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mx-auto max-w-[1200px] px-4 min-[900px]:px-12", className)} {...props} />;
}

/** Landing section with the vertical rhythm of the design system (64px → 96px). */
export function Section({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("py-[clamp(64px,9vw,96px)]", className)} {...props} />;
}

/** Section opener: eyebrow label led by a small navy half-moon, a headline and an optional lead. */
export function SectionHead({
  label,
  title,
  titleId,
  size = "l",
  className,
  children,
}: {
  label: string;
  title: React.ReactNode;
  titleId: string;
  size?: "l" | "m";
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("mb-12 grid max-w-[760px] gap-4", className)}>
      <span className="label inline-flex items-center gap-2.5 before:h-3.5 before:w-[7px] before:flex-none before:rounded-l-[14px] before:bg-par before:content-['']">
        {label}
      </span>
      <h2 id={titleId} className={size === "l" ? "display-l" : "display-m"}>
        {title}
      </h2>
      {children}
    </div>
  );
}
