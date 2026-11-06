"use client";

import { useCallback, useState, type ComponentType, type Dispatch, type SetStateAction } from "react";
import { createPublicChartControls, type PublicChartControls } from "@/lib/public-chart-state";
import { useCustomerSession } from "./customer-session";

export type CustomerWorkspaceProps = { publicChart: PublicChartControls; onPublicChartChange: Dispatch<SetStateAction<PublicChartControls>> };

/** Keep only public controls above the identity/uncertainty remount boundary. */
export function CustomerWorkspaceBoundary({ Workspace }: { Workspace: ComponentType<CustomerWorkspaceProps> }) {
  const { state } = useCustomerSession();
  const [publicChart, onPublicChartChange] = useState(createPublicChartControls);
  return <Workspace key={state.lease?.id ?? "session-held"} publicChart={publicChart} onPublicChartChange={onPublicChartChange} />;
}

export function usePublicChartControl<K extends keyof PublicChartControls>(state: PublicChartControls, dispatch: Dispatch<SetStateAction<PublicChartControls>>, key: K): [PublicChartControls[K], Dispatch<SetStateAction<PublicChartControls[K]>>] {
  const change = useCallback((next: SetStateAction<PublicChartControls[K]>) => dispatch((current) => ({ ...current, [key]: typeof next === "function" ? (next as (value: PublicChartControls[K]) => PublicChartControls[K])(current[key]) : next })), [dispatch, key]);
  return [state[key], change];
}
