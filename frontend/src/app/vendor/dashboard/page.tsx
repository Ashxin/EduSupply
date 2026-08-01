'use client';

import { useVendorMonthlyOrders } from '@/hooks/useMonthlyOrders';
import MonthlyOrdersChart from '@/components/MonthlyOrdersChart';

export default function VendorDashboardPage() {
  const { data, isLoading, isError } = useVendorMonthlyOrders();

  if (isLoading) return <p>Loading...</p>;
  if (isError) return <p>Something went wrong loading your order data.</p>;

  return (
    <div>
      <h1>Orders Per Month</h1>
      <MonthlyOrdersChart data={data ?? []} />
    </div>
  );
}