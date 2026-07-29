"use client";

import { useState, type FormEvent } from "react";
import { submitInquiry } from "@/lib/submit";
import {
  TextField,
  TextArea,
  FormRow,
  FormFeedback,
  Honeypot,
  readHoneypot,
} from "./fields";

const empty = {
  name: "",
  email: "",
  phone: "",
  city: "",
  deadline: "",
  item_or_world_needed: "",
  quantity: "",
  budget: "",
  delivery_or_logistics_needs: "",
};

export function SourcingForm() {
  const [f, setF] = useState(empty);
  const [links, setLinks] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string>();

  const set = (k: keyof typeof empty) => (v: string) => setF((p) => ({ ...p, [k]: v }));


  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const hp = readHoneypot(e.currentTarget);
    setStatus("submitting");
    setError(undefined);
    const res = await submitInquiry("sourcing", links.trim() ? { ...f, reference_links: links.trim() } : f, { hp });
    if (res.ok) {
      setStatus("success");
      setF(empty);
      setLinks("");
    } else {
      setStatus("error");
      setError(res.error);
    }
  }

  if (status === "success") {
    return (
      <FormFeedback
        status="success"
        successMessage="Sourcing request received. We work the network and come back with options — even on the hard ones."
      />
    );
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <Honeypot />
      <FormRow>
        <TextField name="name" label="Name" required value={f.name} onChange={set("name")} />
        <TextField
          name="email"
          label="Email"
          type="email"
          required
          value={f.email}
          onChange={set("email")}
        />
      </FormRow>
      <FormRow>
        <TextField
          name="phone"
          label="Phone"
          type="tel"
          value={f.phone}
          onChange={set("phone")}
        />
        <TextField name="city" label="City" required value={f.city} onChange={set("city")} />
      </FormRow>
      <TextArea
        name="item_or_world_needed"
        label="What do you need?"
        hint="An object, a set of objects, or a whole world. Be specific or be vague — both work."
        required
        rows={5}
        value={f.item_or_world_needed}
        onChange={set("item_or_world_needed")}
        placeholder="The thing that doesn't exist yet, or the thing nobody else can find."
      />
      <FormRow>
        <TextField
          name="quantity"
          label="Quantity"
          value={f.quantity}
          onChange={set("quantity")}
          placeholder="1, a dozen, a room's worth…"
        />
        <TextField
          name="deadline"
          label="Deadline"
          type="date"
          value={f.deadline}
          onChange={set("deadline")}
        />
      </FormRow>
      <FormRow>
        <TextField
          name="budget"
          label="Budget"
          hint="A range is fine. Flexible deals exist for cultural work."
          value={f.budget}
          onChange={set("budget")}
        />
      </FormRow>
      <TextArea
        name="delivery_or_logistics_needs"
        label="Delivery & logistics needs"
        rows={3}
        value={f.delivery_or_logistics_needs}
        onChange={set("delivery_or_logistics_needs")}
        placeholder="Where it needs to land, how it gets there, install or strike support…"
      />
      <TextArea
        name="reference_links"
        label="Reference links"
        hint="Paste links to references — Drive, Dropbox, Pinterest, Are.na, anything viewable."
        rows={2}
        value={links}
        onChange={setLinks}
        placeholder="https://…"
      />

      <FormFeedback status={status} error={error} successMessage="" />
      <button type="submit" className="btn btn--accent" disabled={status === "submitting"}>
        {status === "submitting" ? "Sending…" : "Send sourcing request"}
      </button>
    </form>
  );
}
