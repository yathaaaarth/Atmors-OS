import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function AccessDenied({
  title = "You don't have access to this page",
  description = "If you think this is a mistake, ask an Atmors administrator to check your role.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <Card className="mx-auto w-full max-w-lg" role="alert">
      <CardHeader>
        <CardTitle>
          <h1 className="font-heading text-lg font-semibold">{title}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action="/auth/signout" method="post">
          <button type="submit" className="text-sm font-medium text-brand underline underline-offset-4">
            Sign out
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
