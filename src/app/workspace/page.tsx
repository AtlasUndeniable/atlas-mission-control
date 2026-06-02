import type { Metadata, Viewport } from "next";

import WorkspaceDemoApp from "../workspace-demo/WorkspaceDemoApp";

export const metadata: Metadata = {
  title: "Atlas Workspace",
  description: "Live Atlas agent workspace.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function WorkspacePage() {
  return <WorkspaceDemoApp />;
}
