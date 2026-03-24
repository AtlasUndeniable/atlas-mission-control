"use client";

import { useEffect, useRef, useCallback } from "react";

// ===== TYPES =====
interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  speed: number;      // breathing speed
  offset: number;     // breathing phase offset
  baseOpacity: number;
}

interface ConstellationCanvasProps {
  /** 0→1 opacity, allows boot sequence to fade it in */
  opacity?: number;
  /** When true, dims the canvas to a subtle texture so panels are readable */
  dimmed?: boolean;
}

// ===== CONSTANTS =====
const NODE_COUNT = 70;
const CONNECTION_DISTANCE = 150;
const MOUSE_GLOW_RADIUS = 200;
const MOUSE_REPEL_RADIUS = 100;
const REPEL_FORCE = 2.0;

// ===== COMPONENT =====
export default function ConstellationCanvas({ opacity = 1, dimmed = false }: ConstellationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({ x: -1000, y: -1000, active: false });
  const rafRef = useRef<number>(0);
  const reducedMotionRef = useRef(false);

  // ===== INITIALISE NODES =====
  const initNodes = useCallback((width: number, height: number) => {
    const nodes: Node[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      nodes.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.4,  // -0.2 to 0.2 (drift 0.1-0.3px/frame with damping)
        vy: (Math.random() - 0.5) * 0.4,
        radius: 1.5 + Math.random() * 1.5,     // 1.5-3.0
        speed: 0.5 + Math.random(),           // 0.5-1.5
        offset: Math.random() * Math.PI * 2,  // 0-2π
        baseOpacity: 0.2 + Math.random() * 0.1,
      });
    }
    nodesRef.current = nodes;
  }, []);

  // ===== RENDER LOOP =====
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    // Check reduced motion preference
    reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const dpr = window.devicePixelRatio || 1;

    // Size canvas to viewport
    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Re-init nodes if empty or viewport changed significantly
      if (nodesRef.current.length === 0) {
        initNodes(w, h);
      }
    };

    resize();
    window.addEventListener("resize", resize);

    // Mouse tracking
    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      mouseRef.current.active = true;
    };
    const onMouseLeave = () => {
      mouseRef.current.active = false;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseleave", onMouseLeave);

    // ===== ANIMATION FRAME =====
    let time = 0;

    const draw = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const nodes = nodesRef.current;
      const mouse = mouseRef.current;
      const isStatic = reducedMotionRef.current;

      ctx.clearRect(0, 0, w, h);
      time += 0.016; // ~60fps increment

      // Update positions (unless reduced motion)
      if (!isStatic) {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];

          // Mouse repulsion
          if (mouse.active) {
            const dx = node.x - mouse.x;
            const dy = node.y - mouse.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < MOUSE_REPEL_RADIUS && dist > 0) {
              const force = (1 - dist / MOUSE_REPEL_RADIUS) * REPEL_FORCE;
              node.vx += (dx / dist) * force;
              node.vy += (dy / dist) * force;
            }
          }

          // Apply velocity with damping
          node.x += node.vx;
          node.y += node.vy;
          node.vx *= 0.99;
          node.vy *= 0.99;

          // Wrap edges
          if (node.x < -10) node.x = w + 10;
          else if (node.x > w + 10) node.x = -10;
          if (node.y < -10) node.y = h + 10;
          else if (node.y > h + 10) node.y = -10;
        }
      }

      // ===== DRAW CONNECTIONS =====
      // Spatial optimisation: bucket by x-range
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];

          // Quick x-range check
          const dx = a.x - b.x;
          if (dx > CONNECTION_DISTANCE || dx < -CONNECTION_DISTANCE) continue;

          const dy = a.y - b.y;
          if (dy > CONNECTION_DISTANCE || dy < -CONNECTION_DISTANCE) continue;

          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > CONNECTION_DISTANCE) continue;

          // Breathing modulation on connections
          const breathFactor = 0.8 + 0.2 * ((Math.sin(time * 0.6) + 1) * 0.5);
          let lineOpacity = 0.12 * (1 - dist / CONNECTION_DISTANCE) * breathFactor;

          // Mouse brightness boost for connections
          if (mouse.active) {
            const aDist = Math.sqrt((a.x - mouse.x) ** 2 + (a.y - mouse.y) ** 2);
            const bDist = Math.sqrt((b.x - mouse.x) ** 2 + (b.y - mouse.y) ** 2);
            if (aDist < MOUSE_GLOW_RADIUS || bDist < MOUSE_GLOW_RADIUS) {
              lineOpacity *= 2;
            }
          }

          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(0,136,255,${lineOpacity})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }

      // ===== DRAW NODES =====
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        // Asymmetric breathing — inhale faster than exhale (UI Soul 4.3)
        let nodeOpacity: number;
        if (isStatic) {
          nodeOpacity = node.baseOpacity;
        } else {
          const raw = Math.sin(time * node.speed * 1.6 + node.offset);
          const shaped = raw > 0 ? Math.pow(raw, 0.7) : -Math.pow(-raw, 1.3);
          nodeOpacity = 0.15 + 0.20 * ((shaped + 1) * 0.5);
        }

        // Mouse glow boost — brighten to 0.5 max
        if (mouse.active) {
          const dx = node.x - mouse.x;
          const dy = node.y - mouse.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < MOUSE_GLOW_RADIUS) {
            nodeOpacity = Math.min(nodeOpacity + 0.35 * (1 - dist / MOUSE_GLOW_RADIUS), 0.5);
          }
        }

        // Outer glow halo (subtle)
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,136,255,${nodeOpacity * 0.12})`;
        ctx.fill();

        // Core dot
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,136,255,${nodeOpacity})`;
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [initNodes]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 1,
        pointerEvents: "none",
        opacity: dimmed ? Math.min(opacity, 0.07) : opacity,
        transition: "opacity 1200ms ease-out",
      }}
    />
  );
}
