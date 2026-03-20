"use client";

import { SoundProvider } from "./SoundEngine";
import type { ReactNode } from "react";

export default function Providers({ children }: { children: ReactNode }) {
  return <SoundProvider>{children}</SoundProvider>;
}
