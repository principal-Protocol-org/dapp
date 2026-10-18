import { Container, Section, SectionHead } from "./layout";

export function Architecture() {
  return (
    <Section aria-labelledby="arch-title" className="border-y border-line bg-surface">
      <Container>
        <SectionHead label="Protocol" title="Open and secure infrastructure." titleId="arch-title" className="mb-0">
          <p className="lead">
            Every contract is open source and built on Soroban, with oracle safeguards and a circuit breaker to
            protect every market.
          </p>
        </SectionHead>
      </Container>
    </Section>
  );
}
