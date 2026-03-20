"use client";

import { useEffect, useRef, useState } from "react";

export function useCountUp(target: number, duration: number = 800): number {
  const [current, setCurrent] = useState(0);
  const prevTarget = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (target === prevTarget.current) return;

    const startValue = prevTarget.current;
    const startTime = performance.now();
    prevTarget.current = target;

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(startValue + (target - startValue) * eased);
      setCurrent(value);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    }

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return current;
}
