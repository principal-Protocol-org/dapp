import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MoonPair } from "./brand";
import { Container, Section, SectionHead } from "./layout";
import { SplitReveal } from "./split-reveal";

type Instrument = {
  kind: "pt" | "yt";
  ticker: string;
  name: string;
  body: string;
  attrs: [string, string][];
};

const instruments: Instrument[] = [
  {
    kind: "pt",
    ticker: "PT",
    name: "Principal Token",
    body: "Principal claim redeemable at maturity. Buy it at a discount to lock in a fixed yield.",
    attrs: [
      ["Rate", "Fixed"],
      // Non-breaking spaces keep the ratio on one line.
      ["At maturity", "Redeems 1 : 1"],
      ["For", "Lock in fixed yield"],
    ],
  },
  {
    kind: "yt",
    ticker: "YT",
    name: "Yield Token",
    body: "Yield claim accruing until maturity. Buy it to capture the future yield.",
    attrs: [
      ["Rate", "Variable"],
      ["At maturity", "Expires"],
      ["For", "Trade future yield"],
    ],
  },
];

function HalfMoon({ kind }: { kind: Instrument["kind"] }) {
  return (
    <svg className="split-glyph block h-[52px] w-[26px] flex-none" viewBox="0 0 26 52" aria-hidden="true">
      {kind === "pt" ? (
        <path d="M26 0A26 26 0 0 0 26 52Z" fill="var(--par)" />
      ) : (
        <path d="M0 0A26 26 0 0 1 0 52Z" fill="var(--coupon)" />
      )}
    </svg>
  );
}

export function Instruments() {
  return (
    <Section id="instruments" aria-labelledby="inst-title">
      <Container>
        <SectionHead label="One asset, two instruments" title="Separate the yield from the principal." titleId="inst-title">
          <p className="lead">
            Deposit a yield-bearing RWA and receive a Standardized Yield Token (SY). Split it into a Principal Token
            (PT), a fixed claim redeemable at maturity, and a Yield Token (YT), capturing the yield until maturity.
          </p>
        </SectionHead>

        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-lg border border-dashed border-line-strong px-6 py-4">
          <MoonPair size={9} gap={2} />
          <span className="font-mono font-medium tabular-nums">SY</span>
          <p className="min-w-0 flex-[1_1_280px] text-ink-muted">
            Wrapped yield-bearing token. Split it into PT and YT for a fixed maturity.
          </p>
        </div>

        <SplitReveal className="grid grid-cols-1 gap-6 min-[861px]:grid-cols-2">
          {instruments.map((inst) => (
            <Card
              key={inst.kind}
              data-instrument={inst.kind}
              className="split-card relative grid content-start gap-6 overflow-hidden p-8"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className="font-mono text-[13px]/5 font-medium text-ink-muted">{inst.ticker}</span>
                  <h3 className="font-display text-[30px] leading-[1.1] font-medium">{inst.name}</h3>
                </div>
                <HalfMoon kind={inst.kind} />
              </div>
              <p className="max-w-[60ch] text-base/[26px] text-ink-muted">{inst.body}</p>
              <div className="grid grid-cols-3 border-t border-line">
                {inst.attrs.map(([label, value]) => (
                  <div key={label} className="grid gap-1 pt-4">
                    <span className="label">{label}</span>
                    <b
                      className={cn(
                        "font-mono text-base/[22px] font-medium",
                        inst.kind === "pt" ? "text-par" : "text-coupon-ink"
                      )}
                    >
                      {value}
                    </b>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </SplitReveal>
      </Container>
    </Section>
  );
}
