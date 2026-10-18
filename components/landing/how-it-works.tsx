import { Container, Section, SectionHead } from "./layout";

const steps: { n: string; title: string; body: string }[] = [
  {
    n: "1 · Deposit",
    title: "Receive SY",
    body: "Deposit a yield-bearing RWA and receive a Standardized Yield Token (SY).",
  },
  {
    n: "2 · Split",
    title: "Mint PT and YT",
    body: "Split the asset into Principal Token (PT) and Yield Token (YT) for a fixed maturity.",
  },
  {
    n: "3 · Trade",
    title: "Trade before maturity",
    body: "Trade principal and yield exposure before maturity via the Yield Trading AMM.",
  },
  {
    n: "4 · Claim",
    title: "Settle at maturity",
    body: "Redeem PT at maturity, or claim the yield generated through YT settlements.",
  },
];

export function HowItWorks() {
  return (
    <Section aria-labelledby="how-title" className="border-y border-line bg-surface">
      <Container>
        <SectionHead label="How it works" title="From deposit to claim in four steps." titleId="how-title" />
        <div className="grid grid-cols-1 border-t border-line min-[521px]:grid-cols-2 min-[901px]:grid-cols-4">
          {steps.map((step) => (
            <div key={step.n} className="grid content-start gap-3 py-6 pr-6">
              <span className="font-mono text-[13px]/5 font-medium text-coupon-ink">{step.n}</span>
              <h3 className="font-display text-2xl leading-[1.2] font-medium">{step.title}</h3>
              <p className="text-ink-muted">{step.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </Section>
  );
}
