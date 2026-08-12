import type { Metadata } from "next";
import ExecDashboard from "@/components/ExecDashboard";

// Gated to the Rhys Basic Auth credential in src/middleware.ts. The shared
// operator credential that opens every other route is refused here.
export const metadata: Metadata = {
  title: "Executive | Atlas Mission Control",
};

// Live figures only: never serve this from a build-time or router cache.
export const dynamic = "force-dynamic";

export default function ExecPage() {
  return <ExecDashboard />;
}
