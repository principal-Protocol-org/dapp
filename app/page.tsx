import { Architecture } from "@/components/landing/architecture";
import { CallToAction, SiteFooter } from "@/components/landing/closing";
import { Compliance } from "@/components/landing/compliance";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Instruments } from "@/components/landing/instruments";
import { Markets } from "@/components/landing/markets";
import { Pricing } from "@/components/landing/pricing";
import { SiteHeader } from "@/components/landing/site-header";

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="top">
        <Hero />
        <Instruments />
        <Pricing />
        <HowItWorks />
        <Markets />
        <Compliance />
        <Architecture />
        <CallToAction />
      </main>
      <SiteFooter />
    </>
  );
}
