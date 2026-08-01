'use client';

import { useSchoolMonthlyOrders } from '@/hooks/useMonthlyOrders';
import MonthlyOrdersChart from '@/components/MonthlyOrdersChart';

export default function DashboardPage() {
  const { data, isLoading, isError } = useSchoolMonthlyOrders();

  if (isLoading) return <p>Loading...</p>;
  if (isError) return <p>Something went wrong loading your order data.</p>;

  return (
    <div>
      <h1>Orders Per Month</h1>
      <MonthlyOrdersChart data={data ?? []} />
    </div>
  );
}