import type { Metadata, Viewport } from "next";
import WorkspaceDemoApp from "./WorkspaceDemoApp";

export const metadata: Metadata = {
  title: "Atlas Workspace Demo",
  description: "Event-rendered Atlas workspace preview.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function WorkspaceDemoPage() {
  return <WorkspaceDemoApp />;
}
