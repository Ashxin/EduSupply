import RequireAuth from '@/components/RequireAuth';

export default function VendorDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAuth role="vendor">{children}</RequireAuth>;
}