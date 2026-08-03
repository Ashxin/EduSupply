'use client';

import { useState } from 'react';
import {
  useProducts,
  useCreateProduct,
  useUpdateProduct,
  useDeleteProduct,
  Product,
} from '@/hooks/useProducts';
import Spinner from '@/components/Spinner';

function CreateProductForm() {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [price, setPrice] = useState('');
  const [stockQuantity, setStockQuantity] = useState('');
  const createProduct = useCreateProduct();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createProduct.mutate(
      {
        name,
        category,
        price: Number(price),
        stock_quantity: stockQuantity === '' ? 0 : Number(stockQuantity),
      },
      {
        onSuccess: () => {
          setName('');
          setCategory('');
          setPrice('');
          setStockQuantity('');
        },
      }
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white border border-gray-200 rounded-2xl p-6 mb-6 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
    >
      <div className="sm:col-span-2">
        <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-light"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-light"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Price</label>
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-light"
        />
      </div>
      <div className="sm:col-span-3">
        <label className="block text-xs font-medium text-gray-700 mb-1">Stock quantity</label>
        <input
          type="number"
          min="0"
          value={stockQuantity}
          onChange={(e) => setStockQuantity(e.target.value)}
          placeholder="0"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-light"
        />
      </div>
      <button
        type="submit"
        disabled={createProduct.isPending}
        className="text-sm font-medium text-white bg-gradient-to-r from-brand-dark to-brand-light px-4 py-2 rounded-lg disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {createProduct.isPending ? 'Adding...' : 'Add product'}
      </button>
      {createProduct.isError && (
        <p className="sm:col-span-4 text-sm text-red-600">
          {(createProduct.error as Error).message || 'Something went wrong.'}
        </p>
      )}
    </form>
  );
}

function ProductRow({ product }: { product: Product }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category);
  const [price, setPrice] = useState(product.price);
  const [stockQuantity, setStockQuantity] = useState(String(product.stock_quantity));

  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();

  function handleSave() {
    updateProduct.mutate(
      {
        id: product.id,
        name,
        category,
        price: Number(price),
        stock_quantity: Number(stockQuantity),
      },
      { onSuccess: () => setEditing(false) }
    );
  }

  function handleDelete() {
    if (confirm(`Delete "${product.name}"? This cannot be undone.`)) {
      deleteProduct.mutate(product.id);
    }
  }

  if (editing) {
    return (
      <div className="border border-gray-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end bg-gray-50">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="sm:col-span-2 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0"
          value={stockQuantity}
          onChange={(e) => setStockQuantity(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="sm:col-span-3 flex gap-2">
          <button
            onClick={handleSave}
            disabled={updateProduct.isPending}
            className="text-sm font-medium text-white bg-gradient-to-r from-brand-dark to-brand-light px-4 py-2 rounded-lg disabled:opacity-60"
          >
            {updateProduct.isPending ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={() => setEditing(false)}
            className="text-sm font-medium text-gray-600 px-4 py-2 rounded-lg border border-gray-300"
          >
            Cancel
          </button>
        </div>
        {updateProduct.isError && (
          <p className="sm:col-span-4 text-sm text-red-600">
            {(updateProduct.error as Error).message || 'Update failed.'}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-xl px-5 py-4 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <span className="font-medium text-sm text-gray-800">{product.name}</span>
        <span className="text-xs text-gray-400">{product.category}</span>
        <span className="text-sm text-gray-600">₹{product.price}</span>
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            product.stock_quantity > 0
              ? 'bg-green-100 text-green-700'
              : 'bg-red-100 text-red-700'
          }`}
        >
          {product.stock_quantity} in stock
        </span>
      </div>
      <div className="flex gap-3">
        <button
          onClick={() => setEditing(true)}
          className="text-sm text-brand-dark hover:underline"
        >
          Edit
        </button>
        <button
          onClick={handleDelete}
          disabled={deleteProduct.isPending}
          className="text-sm text-red-600 hover:underline disabled:opacity-60"
        >
          {deleteProduct.isPending ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

export default function ProductsPage() {
  const { data: products, isLoading, isError } = useProducts();

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="font-heading text-2xl font-medium text-brand-dark mb-1">
        Products
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Manage your product catalog
      </p>

      <CreateProductForm />

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      )}

      {isError && (
        <p className="text-sm text-red-600">Something went wrong loading your products.</p>
      )}

      {!isLoading && !isError && products && products.length === 0 && (
        <div className="text-center py-16">
          <p className="text-sm font-medium text-gray-700">No products yet.</p>
          <p className="text-xs text-gray-400 mt-1">Add your first product using the form above.</p>
        </div>
      )}

      {!isLoading && !isError && products && products.length > 0 && (
        <div className="space-y-3">
          {products.map((product) => (
            <ProductRow key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}