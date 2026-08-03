'use client';

import { useSchoolMonthlyOrders } from '@/hooks/useMonthlyOrders';
import MonthlyOrdersChart from '@/components/MonthlyOrdersChart';
import Spinner from '@/components/Spinner';

export default function DashboardPage() {
  const { data, isLoading, isError } = useSchoolMonthlyOrders();

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="font-heading text-2xl font-medium text-brand-dark mb-1">
        Orders per month
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Track your ordering activity over time
      </p>

      <div className="bg-white border border-gray-200 rounded-2xl p-6">
        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Spinner />
          </div>
        )}
        {isError && (
          <div className="text-center py-16">
            <p className="text-sm text-red-600">
              Something went wrong loading your order data.
            </p>
          </div>
        )}
        {!isLoading && !isError && <MonthlyOrdersChart data={data ?? []} />}
      </div>
    </div>
  );
}