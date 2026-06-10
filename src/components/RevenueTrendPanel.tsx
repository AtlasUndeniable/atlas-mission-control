"use client";

import { useEffect, useState } from "react";

interface RecentPayment {
  name: string;
  amount: number;
  date: string | null;
}

interface RevenueData {
  totalRevenue: number;
  mrr: number;
  activeSubscribers: number;
  recentPayments: RecentPayment[];
  churnEvents: number;
  oneOffTotal: number;
  paymentsCount: number;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

export default function RevenueTrendPanel() {
  const [revenue, setRevenue] = useState<RevenueData | null>(null);

  useEffect(() => {
    fetch("/api/overview")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.revenue) setRevenue(d.revenue);
      })
      .catch(() => {});
  }, []);

  const hasData = revenue !== null && (revenue.totalRevenue > 0 || revenue.recentPayments.length > 0);
  const payments = revenue?.recentPayments ?? [];

  return (
    <div className="glass-card hud-corners p-5">
      <div className="flex items-center gap-3 mb-4">
        <span
          className={`status-dot ${hasData ? "operational" : "degraded"}`}
          style={{ width: "6px", height: "6px" }}
        />
        <p className="type-section-header">Revenue Trend</p>
      </div>

      {hasData ? (
        <>
          {/* Recent payments feed */}
          <div style={{ minHeight: "110px" }}>
            {payments.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {payments.slice(0, 6).map((p, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "4px 8px",
                      borderRadius: "4px",
                      background: "rgba(255,255,255,0.02)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      <span
                        style={{
                          fontFamily: "var(--font-body)",
                          fontSize: "12px",
                          color: "rgba(255,255,255,0.7)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.name}
                      </span>
                      {p.date && (
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "10px",
                            color: "rgba(255,255,255,0.25)",
                            flexShrink: 0,
                          }}
                        >
                          {formatDate(p.date)}
                        </span>
                      )}
                    </div>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "rgba(0,200,255,0.8)",
                        flexShrink: 0,
                        marginLeft: "12px",
                      }}
                    >
                      ${p.amount.toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: "110px",
                }}
              >
                <p
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "11px",
                    color: "rgba(255,255,255,0.20)",
                    letterSpacing: "0.05em",
                  }}
                >
                  No recent payments
                </p>
              </div>
            )}
          </div>

          {/* Secondary stats */}
          <div
            className="mt-3"
            style={{
              display: "flex",
              gap: "16px",
              borderTop: "1px solid rgba(255,255,255,0.05)",
              paddingTop: "10px",
            }}
          >
            <div>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  color: "rgba(255,255,255,0.3)",
                  letterSpacing: "0.05em",
                  marginBottom: "2px",
                }}
              >
                SUBSCRIBERS
              </p>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "16px",
                  fontWeight: 700,
                  color: "rgba(255,255,255,0.8)",
                }}
              >
                {revenue!.activeSubscribers}
              </p>
            </div>
            <div>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  color: "rgba(255,255,255,0.3)",
                  letterSpacing: "0.05em",
                  marginBottom: "2px",
                }}
              >
                MRR
              </p>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "16px",
                  fontWeight: 700,
                  color: "rgba(255,255,255,0.8)",
                }}
              >
                ${revenue!.mrr.toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </p>
            </div>
            {revenue!.churnEvents > 0 && (
              <div>
                <p
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "10px",
                    color: "rgba(255,255,255,0.3)",
                    letterSpacing: "0.05em",
                    marginBottom: "2px",
                  }}
                >
                  CHURN (30D)
                </p>
                <p
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "16px",
                    fontWeight: 700,
                    color: "rgba(255,140,0,0.8)",
                  }}
                >
                  {revenue!.churnEvents}
                </p>
              </div>
            )}
          </div>
        </>
      ) : (
        /* Empty state */
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "110px",
            borderRadius: "6px",
            border: "1px dashed rgba(255,255,255,0.06)",
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              color: "rgba(255,255,255,0.20)",
              letterSpacing: "0.05em",
              textAlign: "center",
            }}
          >
            Awaiting first transaction
          </p>
        </div>
      )}

      <p
        className="mt-3"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "9px",
          color: hasData ? "rgba(0,200,255,0.30)" : "rgba(255,255,255,0.15)",
          letterSpacing: "0.1em",
          textAlign: "center",
        }}
      >
        {hasData ? "LIVE \u2014 NEWIE CONNECTED" : "AWAITING FIRST TRANSACTION"}
      </p>
    </div>
  );
}
