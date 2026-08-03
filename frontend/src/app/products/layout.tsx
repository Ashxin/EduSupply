import RequireAuth from '@/components/RequireAuth';
import NavBar from '@/components/NavBar';

export default function ProductsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireAuth role="vendor">
      <NavBar role="vendor" />
      {children}
    </RequireAuth>
  );
}