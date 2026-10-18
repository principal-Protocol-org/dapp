export const links = {
  /** The app is served by this Next.js project under /app. */
  app: "/app",
  docs: "https://github.com/principal-Protocol-org/principal/tree/main/docs",
  github: "https://github.com/principal-Protocol-org/principal",
  // TODO: set the community URLs; footer links without a URL are not rendered.
  discord: null as string | null,
  x: null as string | null,
} as const;

export type MarketRow = {
  asset: string;
  issuer: string;
  activeMarkets: string;
  totalLiquidity: string;
  fixedApy: string;
  status: { label: string; tone: "soon" | "live" | "dev" };
};

export const markets: MarketRow[] = [
  {
    asset: "USDY",
    issuer: "Ondo Finance",
    activeMarkets: "—",
    totalLiquidity: "—",
    fixedApy: "—",
    status: { label: "Coming soon", tone: "soon" },
  },
  {
    asset: "BENJI",
    issuer: "Franklin Templeton",
    activeMarkets: "—",
    totalLiquidity: "—",
    fixedApy: "—",
    status: { label: "Coming soon", tone: "soon" },
  },
];
