'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { MonthlyOrderPoint } from '@/hooks/useMonthlyOrders';

export default function MonthlyOrdersChart({ data }: { data: MonthlyOrderPoint[] }) {
  if (data.length === 0) {
    return <p>No order data yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Line type="monotone" dataKey="order_count" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}