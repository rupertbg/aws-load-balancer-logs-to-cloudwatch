FROM public.ecr.aws/lambda/nodejs:20
LABEL org.opencontainers.image.source="https://github.com/rupertbg/aws-load-balancer-logs-to-cloudwatch"
COPY src /var/task
WORKDIR /var/task
RUN npm ci
CMD [ "index.handler" ]