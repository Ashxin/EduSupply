'use client';

import { useVendorMonthlyOrders } from '@/hooks/useMonthlyOrders';
import MonthlyOrdersChart from '@/components/MonthlyOrdersChart';

export default function VendorDashboardPage() {
  const { data, isLoading, isError } = useVendorMonthlyOrders();

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="font-heading text-2xl font-medium text-brand-dark mb-1">
        Orders per month
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Track your ordering activity over time
      </p>

      <div className="bg-white border border-gray-200 rounded-2xl p-6">
        {isLoading && <p className="text-sm text-gray-500">Loading...</p>}
        {isError && (
          <p className="text-sm text-red-600">
            Something went wrong loading your order data.
          </p>
        )}
        {!isLoading && !isError && <MonthlyOrdersChart data={data ?? []} />}
      </div>
    </div>
  );
}