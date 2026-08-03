'use client';

import { useState } from 'react';
import { useOrders, useOrderDetail, useReorder, Order } from '@/hooks/useOrders';
import Spinner from '@/components/Spinner';

const STATUS_STYLES: Record<Order['status'], string> = {
  pending: 'bg-gray-100 text-gray-700',
  accepted: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
  completed: 'bg-green-100 text-green-700',
  canceled: 'bg-red-100 text-red-700',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function OrderRow({ order }: { order: Order }) {
  const [expanded, setExpanded] = useState(false);
  const { data: items, isLoading: itemsLoading } = useOrderDetail(order.id, expanded);
  const reorder = useReorder();

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{formatDate(order.created_at)}</span>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_STYLES[order.status]}`}>
            {order.status.replace('_', ' ')}
          </span>
        </div>
        <span className="text-gray-400 text-sm">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-5 py-4 bg-gray-50">
          {itemsLoading && (
            <div className="flex justify-center py-4">
              <Spinner size={20} />
            </div>
          )}
          {items && items.length > 0 && (
            <ul className="space-y-2 mb-4">
              {items.map((item) => (
                <li key={item.product_id} className="flex justify-between text-sm text-gray-700">
                  <span>{item.name} × {item.quantity}</span>
                  <span className="text-gray-500">₹{item.price_at_order}</span>
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={() => reorder.mutate(order.id)}
            disabled={reorder.isPending}
            className="text-sm font-medium text-white bg-gradient-to-r from-brand-dark to-brand-light px-4 py-2 rounded-lg disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
          >
            {reorder.isPending ? 'Reordering...' : 'Reorder'}
          </button>

          {reorder.isSuccess && (
            <p className="text-sm text-green-600 mt-2">New order placed successfully.</p>
          )}
          {reorder.isError && (
            <p className="text-sm text-red-600 mt-2">
              {(reorder.error as Error).message || 'Reorder failed. Please try again.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function OrdersPage() {
  const { data: orders, isLoading, isError } = useOrders();

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="font-heading text-2xl font-medium text-brand-dark mb-1">
        Order history
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        View past orders and reorder in one click
      </p>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      )}

      {isError && (
        <p className="text-sm text-red-600">Something went wrong loading your orders.</p>
      )}

      {!isLoading && !isError && orders && orders.length === 0 && (
        <div className="text-center py-16">
          <p className="text-sm font-medium text-gray-700">No orders yet.</p>
          <p className="text-xs text-gray-400 mt-1">Your placed orders will show up here.</p>
        </div>
      )}

      {!isLoading && !isError && orders && orders.length > 0 && (
        <div className="space-y-3">
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </div>
      )}
    </div>
  );
}