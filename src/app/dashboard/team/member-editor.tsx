"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { updateMembership } from "./actions";
import { MEMBER_ROLES, MEMBER_STATUSES, updateMembershipSchema, type UpdateMembershipValues } from "./schema";

const ROLE_OPTIONS: Record<(typeof MEMBER_ROLES)[number], string> = {
  ceo: "CEO",
  cto_coo: "CTO / COO",
  delivery: "Delivery",
};

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

export function MemberEditor({
  membershipId,
  role,
  status,
  memberName,
}: {
  membershipId: string;
  role: UpdateMembershipValues["role"];
  status: UpdateMembershipValues["status"];
  memberName: string;
}) {
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<UpdateMembershipValues>({
    resolver: zodResolver(updateMembershipSchema),
    defaultValues: { membershipId, role, status, reason: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setMessage(null);
    if (!window.confirm(`Change access for ${memberName}? This is recorded in the audit log.`)) return;
    const result = await updateMembership(values);
    if (result.ok) {
      reset({ membershipId, role: values.role, status: values.status, reason: "" });
      setMessage({ tone: "success", text: "Saved and recorded in the audit log." });
    } else {
      setMessage({
        tone: "error",
        text: `${result.error.message} (ref ${result.error.correlation_id.slice(0, 8)})`,
      });
    }
  });

  const idPrefix = `member-${membershipId}`;

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-3 sm:grid-cols-[8rem_8rem_1fr_auto] sm:items-end">
      <input type="hidden" {...register("membershipId")} />
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-role`}>Role</Label>
        <select id={`${idPrefix}-role`} className={selectClass} {...register("role")}>
          {MEMBER_ROLES.map((value) => (
            <option key={value} value={value}>
              {ROLE_OPTIONS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-status`}>Status</Label>
        <select id={`${idPrefix}-status`} className={selectClass} {...register("status")}>
          {MEMBER_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value[0].toUpperCase() + value.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-reason`}>Reason</Label>
        <Input
          id={`${idPrefix}-reason`}
          placeholder="Why is this changing?"
          aria-invalid={errors.reason ? true : undefined}
          aria-describedby={errors.reason ? `${idPrefix}-reason-error` : undefined}
          {...register("reason")}
        />
      </div>
      <Button type="submit" disabled={isSubmitting || !isDirty}>
        {isSubmitting ? "Saving…" : "Save"}
      </Button>
      {errors.reason ? (
        <p id={`${idPrefix}-reason-error`} role="alert" className="text-sm text-destructive sm:col-span-4">
          {errors.reason.message}
        </p>
      ) : null}
      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={message.tone === "error" ? "text-sm text-destructive sm:col-span-4" : "text-sm text-success sm:col-span-4"}
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
