
output "lambda_arn" {
    value = module.lambda_function.lambda_function_arn
}

output "ecr_image_uri" {
    value = module.docker_image.image_uri
}
