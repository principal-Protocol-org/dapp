import { Container, Section, SectionHead } from "./layout";

const pillars: { title: string; body: string }[] = [
  {
    title: "Administration",
    body: "The underlying RWA administrator controls market creation and compliance rights.",
  },
  {
    title: "Authorization",
    body: "Only wallets authorized to hold the underlying RWA can hold and trade PT/YT.",
  },
  {
    title: "Clawback",
    body: "PT/YT positions can be settled into the underlying RWA for native clawback.",
  },
];

export function Compliance() {
  return (
    <Section id="compliance" aria-labelledby="comp-title" className="pt-0">
      <Container>
        <SectionHead label="Compliance architecture" title="Compliance inherited by design" titleId="comp-title">
          <p className="lead">Principal extends the underlying RWA&apos;s native compliance controls to PT/YT markets.</p>
        </SectionHead>
        <div className="grid grid-cols-1 gap-6 min-[861px]:grid-cols-3">
          {pillars.map((p) => (
            <div key={p.title} className="grid content-start gap-3 border-t-2 border-par pt-4">
              <h3 className="text-[19px]/[26px] font-semibold">{p.title}</h3>
              <p className="text-ink-muted">{p.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </Section>
  );
}
