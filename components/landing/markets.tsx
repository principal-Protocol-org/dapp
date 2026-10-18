import { Badge } from "@/components/ui/badge";
import { Button, ButtonArrow } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { links, markets } from "@/lib/content";
import { Container, Section, SectionHead } from "./layout";

export function Markets() {
  return (
    <Section id="markets" aria-labelledby="mk-title">
      <Container>
        <SectionHead label="Markets" title="Starting with tokenized US Treasuries." titleId="mk-title">
          <p className="lead">
            Principal first targets Stellar&apos;s most established regulated RWAs, backed by US Treasuries.
          </p>
        </SectionHead>

        <div className="grid items-start gap-6 min-[961px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Table containerClassName="rounded-lg border border-line bg-surface" className="min-w-[620px]">
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead className="text-right">Active markets</TableHead>
                <TableHead className="text-right">Total liquidity</TableHead>
                <TableHead className="text-right">Fixed APY</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {markets.map((m) => (
                <TableRow key={m.asset}>
                  <TableCell>
                    <span className="block font-sans text-[15px]/5 font-semibold">{m.asset}</span>
                    <span className="font-sans text-xs/4 text-ink-muted">{m.issuer}</span>
                  </TableCell>
                  <TableCell className="text-right">{m.activeMarkets}</TableCell>
                  <TableCell className="text-right">{m.totalLiquidity}</TableCell>
                  <TableCell className="text-right">{m.fixedApy}</TableCell>
                  <TableCell>
                    <Badge status={m.status.tone}>{m.status.label}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Card raised aria-label="USDY market" className="grid gap-6">
            <CardHeader>
              <div>
                <CardTitle>USDY · Dec 2026</CardTitle>
                <CardDescription>Ondo Finance · Tokenized US Treasuries</CardDescription>
              </div>
              <Badge status="soon">Coming soon</Badge>
            </CardHeader>
            <div className="grid gap-0.5 rounded-md bg-surface-sunk p-4">
              <span className="label">Fixed APY</span>
              <b className="font-mono text-[30px]/[34px] font-medium tracking-[-0.02em] text-par tabular-nums">—</b>
            </div>
            <dl>
              {[
                ["Maturity", "31 Dec 2026"],
                ["Total liquidity", "—"],
                ["Oracle", "RedStone USDY/USD"],
              ].map(([term, value]) => (
                <div
                  key={term}
                  className="flex justify-between border-t border-line py-2.5 font-mono text-[13px]/5 tabular-nums"
                >
                  <dt className="font-sans text-ink-muted">{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <Button asChild>
              <a href={links.app}>
                View market <ButtonArrow />
              </a>
            </Button>
          </Card>
        </div>
      </Container>
    </Section>
  );
}
