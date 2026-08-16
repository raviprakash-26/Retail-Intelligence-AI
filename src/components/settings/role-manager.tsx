"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Lock, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PermissionKey } from "@/lib/rbac/permissions";
import {
  createRoleAction,
  deleteRoleAction,
  updateRoleAction,
} from "@/server/rbac/role-actions";
import type { RoleView } from "@/server/rbac/role-service";

/**
 * Roles a business defines for itself.
 *
 * Only the permissions the person holds are offered. Showing everything and
 * refusing on save would teach the rule by rejection, which is a worse way to
 * learn it — and would leave somebody staring at a checkbox wondering whether
 * the product is broken.
 *
 * Built-in roles are listed but not editable. They are shown because a person
 * choosing a role wants to see all of them side by side, and locked because
 * every business is seeded from the same six.
 */
export function RoleManager({
  roles,
  grantable,
  descriptions,
  canManage,
}: {
  roles: RoleView[];
  grantable: PermissionKey[];
  descriptions: Record<string, { module: string; description: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<RoleView | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [chosen, setChosen] = React.useState<Set<PermissionKey>>(new Set());
  const [pending, setPending] = React.useState(false);

  const byModule = React.useMemo(() => {
    const groups = new Map<string, PermissionKey[]>();
    for (const key of grantable) {
      const group = descriptions[key]?.module ?? "Other";
      groups.set(group, [...(groups.get(group) ?? []), key]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [grantable, descriptions]);

  function open(role: RoleView | null) {
    setEditing(role);
    setCreating(role === null);
    setName(role?.name ?? "");
    setChosen(new Set(role?.permissions ?? []));
  }

  function close() {
    setEditing(null);
    setCreating(false);
    setName("");
    setChosen(new Set());
  }

  async function save() {
    setPending(true);
    const permissions = [...chosen];
    const result = creating
      ? await createRoleAction({ name, permissions })
      : await updateRoleAction({ roleId: editing!.id, name, permissions });
    setPending(false);

    if (result.ok) {
      toast.success(creating ? `${name} created.` : `${name} saved.`);
      close();
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  async function remove(role: RoleView) {
    setPending(true);
    const result = await deleteRoleAction({ roleId: role.id });
    setPending(false);
    if (result.ok) {
      toast.success(`${role.name} removed.`);
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => open(null)}>
            <Plus aria-hidden="true" />
            New role
          </Button>
        </div>
      )}

      <ul className="divide-y rounded-xl border">
        {roles.map((role) => (
          <li
            key={role.id}
            className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {role.name}
                {role.isSystem && (
                  <Badge variant="muted" className="text-[0.625rem]">
                    <Lock className="size-2.5" aria-hidden="true" />
                    Built in
                  </Badge>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {role.permissions.length} permission
                {role.permissions.length === 1 ? "" : "s"} · {role.members}{" "}
                {role.members === 1 ? "person" : "people"}
              </p>
            </div>

            {canManage && !role.isSystem && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => open(role)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => remove(role)}
                  aria-label={`Remove ${role.name}`}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <Dialog
        open={editing !== null || creating}
        onOpenChange={(n) => !n && close()}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {creating ? "New role" : `Edit ${editing?.name}`}
            </DialogTitle>
            <DialogDescription>
              Only what you can do yourself is on offer here. A role cannot be
              given a permission you do not hold — otherwise building one would
              be a way to promote yourself.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Counter staff"
            />
          </div>

          <div className="space-y-4">
            {byModule.map(([group, keys]) => (
              <fieldset key={group} className="space-y-1.5">
                <legend className="text-xs font-semibold tracking-wide uppercase">
                  {group}
                </legend>
                {keys.map((key) => (
                  <label
                    key={key}
                    className="flex items-start gap-2 text-sm"
                    htmlFor={`perm-${key}`}
                  >
                    <Checkbox
                      id={`perm-${key}`}
                      checked={chosen.has(key)}
                      onCheckedChange={(next) => {
                        const copy = new Set(chosen);
                        if (next) copy.add(key);
                        else copy.delete(key);
                        setChosen(copy);
                      }}
                    />
                    <span>{descriptions[key]?.description ?? key}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>

          <DialogFooter>
            <Button
              type="button"
              onClick={save}
              disabled={pending || name.trim().length < 2 || chosen.size === 0}
            >
              {creating ? "Create the role" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
