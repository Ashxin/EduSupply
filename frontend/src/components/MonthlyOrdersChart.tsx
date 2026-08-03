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

const BRAND_DARK = '#1f4037';

export default function MonthlyOrdersChart({ data }: { data: MonthlyOrderPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-brand-dark to-brand-light mb-4" />
        <p className="text-sm font-medium text-gray-700">No order data yet.</p>
        <p className="text-xs text-gray-400 mt-1">
          Your order activity will show up here once you place your first order.
        </p>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={BRAND_DARK} strokeOpacity={0.15} />
        <XAxis dataKey="month" stroke={BRAND_DARK} tick={{ fill: BRAND_DARK, fontSize: 12 }} />
        <YAxis allowDecimals={false} stroke={BRAND_DARK} tick={{ fill: BRAND_DARK, fontSize: 12 }} />
        <Tooltip />
        <Line
          type="monotone"
          dataKey="order_count"
          stroke={BRAND_DARK}
          strokeWidth={2}
          dot={{ r: 3, fill: '#99f2c8', stroke: BRAND_DARK, strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}