/**
 * A table of records (P13, D-P13-07): shadcn's data table over TanStack Table,
 * with sortable columns. Pages give columns and rows; how a table looks is
 * `components/ui/table.tsx`'s and `theme.css`'s.
 */
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const DataTable = <T,>({
  columns,
  rows,
  initialSort = [],
  empty = "Nothing yet.",
  label,
}: {
  readonly columns: ColumnDef<T, unknown>[];
  readonly rows: readonly T[];
  readonly initialSort?: SortingState;
  readonly empty?: string;
  readonly label?: string;
}) => {
  const [sorting, setSorting] = useState<SortingState>(initialSort);
  const table = useReactTable({
    data: rows as T[],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return (
    <div className="rounded-md border">
      <Table aria-label={label}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                const content = flexRender(header.column.columnDef.header, header.getContext());
                return (
                  <TableHead key={header.id}>
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {content}
                        {sorted === "asc" ? <ArrowUp className="size-3" /> : null}
                        {sorted === "desc" ? <ArrowDown className="size-3" /> : null}
                      </button>
                    ) : (
                      content
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-16 text-center text-muted-foreground"
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
};
