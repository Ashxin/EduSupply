import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Order {
  id: string;
  vendor_id: string;
  school_id: string;
  status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'canceled';
  created_at: string;
}

export interface OrderItem {
  product_id: string;
  quantity: number;
  price_at_order: string;
  name: string;
}

export function useOrders() {
  return useQuery({
    queryKey: ['orders'],
    queryFn: async () => {
      const data = await apiFetch('/orders');
      return data.orders as Order[];
    },
  });
}

export function useOrderDetail(orderId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['orderDetail', orderId],
    queryFn: async () => {
      const data = await apiFetch(`/orders/${orderId}`);
      return data.items as OrderItem[];
    },
    enabled,
  });
}

export function useReorder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orderId: string) => {
      return apiFetch(`/orders/${orderId}/reorder`, { method: 'POST' });
    },
    onSuccess: () => {
      // A new order was created — refresh the list and the dashboard chart
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['monthlyOrders', 'school'] });
    },
  });
}