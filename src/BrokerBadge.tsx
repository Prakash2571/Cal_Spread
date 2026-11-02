import type { BrokerId } from "./api.ts";

/** A record's broker; rows without a broker predate Dhan and belong to Zerodha. */
export function BrokerBadge({ broker }: { broker?: BrokerId | null }) {
  const isDhan = broker === "dhan";
  return (
    <span
      className={`box-broker ${isDhan ? "box-broker--dhan" : "box-broker--zerodha"}`}
      title={`Broker: ${isDhan ? "Dhan" : "Zerodha"}`}
    >
      {isDhan ? "DHAN" : "ZERODHA"}
    </span>
  );
}
