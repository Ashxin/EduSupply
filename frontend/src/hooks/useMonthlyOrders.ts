import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface MonthlyOrderPoint {
  month: string;       // formatted label, e.g. "Jan 2026"
  order_count: number;
}

interface RawMonthlyRow {
  month: string;        // ISO timestamp from DATE_TRUNC
  order_count: string;  // Postgres COUNT(*) comes back as a string
}

function formatMonthLabel(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function transformRows(rows: RawMonthlyRow[]): MonthlyOrderPoint[] {
  return rows.map((row) => ({
    month: formatMonthLabel(row.month),
    order_count: Number(row.order_count),
  }));
}

export function useSchoolMonthlyOrders() {
  return useQuery({
    queryKey: ['monthlyOrders', 'school'],
    queryFn: async () => {
      const data = await apiFetch('/orders/monthly');
      return transformRows(data.monthly_orders);
    },
  });
}

export function useVendorMonthlyOrders() {
  return useQuery({
    queryKey: ['monthlyOrders', 'vendor'],
    queryFn: async () => {
      const data = await apiFetch('/vendor/orders/monthly');
      return transformRows(data.monthly_orders);
    },
  });
}