import RequireAuth from '@/components/RequireAuth';
import NavBar from '@/components/NavBar';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireAuth role="school">
      <NavBar role="school" />
      {children}
    </RequireAuth>
  );
}