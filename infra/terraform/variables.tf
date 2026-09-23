variable "region" {
  type    = string
  default = "ap-mumbai-1"

  validation {
    condition     = var.region == "ap-mumbai-1"
    error_message = "Production is OCI ap-mumbai-1. TLS must terminate in India."
  }
}

variable "cloudflare_proxied" {
  type        = bool
  default     = false
  description = "Cloudflare is DNS only. Proxying terminates TLS outside India."

  validation {
    condition     = var.cloudflare_proxied == false
    error_message = "Cloudflare must stay DNS only."
  }
}

variable "tenancy_ocid" {
  type = string
}

variable "compartment_ocid" {
  type = string
}

variable "user_ocid" {
  type = string
}

variable "fingerprint" {
  type = string
}

variable "private_key_path" {
  type = string
}

variable "ssh_public_key" {
  type = string
}

variable "availability_domain" {
  type = string
}

variable "repo_url" {
  type = string
}

variable "git_ref" {
  type    = string
  default = "main"
}
