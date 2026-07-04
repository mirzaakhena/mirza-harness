export const HOSTD_VERSION = "0.0.1";

export interface DoctorReport {
  ok: boolean;
  version: string;
  pid: number;
  uptime_s: number;
  db: string;
  components: Record<string, string>;
}

export function doctorReport(): DoctorReport {
  return {
    ok: true,
    version: HOSTD_VERSION,
    pid: process.pid,
    uptime_s: Math.floor(process.uptime()),
    db: "not-connected (menyusul fase 1)",
    components: { bus: "stub", state: "stub", adapters: "stub", supervisors: "stub" },
  };
}
