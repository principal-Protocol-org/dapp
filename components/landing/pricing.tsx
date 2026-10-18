import { Container, Section, SectionHead } from "./layout";
import { PricingChart } from "./pricing-chart";

export function Pricing() {
  return (
    <Section aria-labelledby="price-title" className="pt-0">
      <Container>
        <PricingChart>
          <SectionHead
            label="Time-aware pricing"
            title="PT converges to par. YT decays to zero."
            titleId="price-title"
            size="m"
            className="mb-0"
          >
            <p className="text-[15px]/6 text-ink-muted">
              The PT/SY pool&apos;s curve is parameterised by time to maturity, so liquidity providers carry no
              structural loss as PT pulls to par.
            </p>
          </SectionHead>
        </PricingChart>
      </Container>
    </Section>
  );
}
