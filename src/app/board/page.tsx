import type { Metadata } from "next";
import ActionBoard from "@/components/ActionBoard";

// Gated to the Rhys Basic Auth credential in src/middleware.ts — the same pair
// that opens /exec, so one login covers both surfaces. The shared operator
// credential that opens every other route is refused here.
export const metadata: Metadata = {
  title: "Action Board | Atlas Mission Control",
};

// Live rows only: never serve this from a build-time or router cache.
export const dynamic = "force-dynamic";

export default function BoardPage() {
  return <ActionBoard />;
}
