"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { MoonPair } from "./brand";

const noop = () => () => {};

/** Light by default; the toggle offers the deep-navy dark theme. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // The stored theme is only known on the client: render the light state until mounted.
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const dark = mounted && resolvedTheme === "dark";

  return (
    <Button
      type="button"
      variant="toggle"
      size="toggle"
      aria-pressed={dark}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      <MoonPair size={5} gap={2} />
      <span className="max-[520px]:hidden">{dark ? "Light" : "Dark"}</span>
    </Button>
  );
}
