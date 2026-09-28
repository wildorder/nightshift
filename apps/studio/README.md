# @nightshift/studio

The Nightshift Studio (P11): a hosted client of the control plane and nothing
else (A-15a). It is served from CloudFront at `studio.<stage>.nightshift.wildorder.dev`
and reads and writes only through the routes the API serves, as the CLI does.

Running it from this repository (`npm run studio`) is for developing the Studio
itself (D-P11-01): the same build against the same control plane, signed in
through the `dev` stage's Studio client, which alone registers the localhost
callback. It is not a product mode.
